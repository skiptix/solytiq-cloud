import { describe, expect, it } from 'vitest';
import { RequestMetricsRingBuffer, percentile } from '../requestMetrics';

describe('percentile — pure nearest-rank percentile over a sorted array', () => {
  it('returns null for an empty array', () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it('returns the single element for a 1-element array at any percentile', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
    expect(percentile([42], 0.01)).toBe(42);
  });

  it('p50 of [1..10] is the 5th value (nearest-rank)', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
  });

  it('p99 of [1..100] is close to the max, not the max itself', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 0.99)).toBe(99);
  });

  it('p=0 returns the minimum, p=1 returns the maximum (clamped, no out-of-bounds)', () => {
    const sorted = [10, 20, 30];
    expect(percentile(sorted, 0)).toBe(10);
    expect(percentile(sorted, 1)).toBe(30);
  });

  it('never throws or returns undefined for boundary percentiles', () => {
    const sorted = [5];
    expect(percentile(sorted, 0)).toBe(5);
    expect(percentile(sorted, 1)).toBe(5);
  });
});

describe('RequestMetricsRingBuffer — bounded-memory latency window', () => {
  it('constructor rejects a non-positive capacity', () => {
    expect(() => new RequestMetricsRingBuffer(0)).toThrow();
    expect(() => new RequestMetricsRingBuffer(-5)).toThrow();
    expect(() => new RequestMetricsRingBuffer(NaN)).toThrow();
  });

  it('an empty buffer snapshots to null percentiles and zero counts', () => {
    const buf = new RequestMetricsRingBuffer(10);
    const snap = buf.snapshot();
    expect(snap.totalRequests).toBe(0);
    expect(snap.windowSize).toBe(0);
    expect(snap.p50).toBeNull();
    expect(snap.p95).toBeNull();
    expect(snap.p99).toBeNull();
    expect(snap.errorCount5xx).toBe(0);
  });

  it('totalRequests counts every record() call, unbounded — even past ring capacity', () => {
    const buf = new RequestMetricsRingBuffer(5);
    for (let i = 0; i < 12; i++) buf.record({ durationMs: i, status: 200, method: 'GET', route: '/x' });
    expect(buf.snapshot().totalRequests).toBe(12);
  });

  it('windowSize never exceeds capacity — bounded memory, the whole point of the ring buffer', () => {
    const buf = new RequestMetricsRingBuffer(5);
    for (let i = 0; i < 100; i++) buf.record({ durationMs: i, status: 200, method: 'GET', route: '/x' });
    expect(buf.snapshot().windowSize).toBe(5);
  });

  it('after wrapping, the window holds only the MOST RECENT samples, not the oldest', () => {
    const buf = new RequestMetricsRingBuffer(3);
    // Fill with [100, 200, 300], then overwrite with [1, 2] — window should
    // now be exactly {300, 1, 2}, not include the overwritten 100/200.
    buf.record({ durationMs: 100, status: 200, method: 'GET', route: '/x' });
    buf.record({ durationMs: 200, status: 200, method: 'GET', route: '/x' });
    buf.record({ durationMs: 300, status: 200, method: 'GET', route: '/x' });
    buf.record({ durationMs: 1, status: 200, method: 'GET', route: '/x' });
    buf.record({ durationMs: 2, status: 200, method: 'GET', route: '/x' });
    const snap = buf.snapshot();
    expect(snap.windowSize).toBe(3);
    // The min/max of the CURRENT window should reflect {300,1,2}, not {100,200,300}.
    expect(snap.p50).toBe(2); // sorted [1,2,300] -> nearest-rank p50 is index 1 -> 2
  });

  it('errorCount5xx counts only >=500 statuses within the current window', () => {
    const buf = new RequestMetricsRingBuffer(10);
    buf.record({ durationMs: 10, status: 200, method: 'GET', route: '/a' });
    buf.record({ durationMs: 10, status: 404, method: 'GET', route: '/b' });
    buf.record({ durationMs: 10, status: 500, method: 'GET', route: '/c' });
    buf.record({ durationMs: 10, status: 503, method: 'GET', route: '/d' });
    expect(buf.snapshot().errorCount5xx).toBe(2);
  });

  it('a 404/403 (client error) is NOT counted as an error in errorCount5xx — only server errors', () => {
    const buf = new RequestMetricsRingBuffer(10);
    buf.record({ durationMs: 10, status: 404, method: 'GET', route: '/a' });
    buf.record({ durationMs: 10, status: 403, method: 'GET', route: '/b' });
    expect(buf.snapshot().errorCount5xx).toBe(0);
  });

  it('p50/p95/p99 are computed correctly over a realistic mixed-latency window', () => {
    const buf = new RequestMetricsRingBuffer(100);
    // 100 samples: 90 fast (10ms, indices 0-89), 9 medium (100ms, indices
    // 90-98), 1 slow (1000ms, index 99) — a classic long-tail distribution.
    // Nearest-rank: rank(p) = ceil(p*100)-1 (0-based). p50 -> rank 49 -> the
    // "10ms" group. p95 -> rank 94 -> still the "100ms" group (indices
    // 90-98). p99 -> rank 98 -> the LAST "100ms" sample, not the single
    // 1000ms outlier at index 99 — nearest-rank p99 over exactly 100 samples
    // needs the 100th value (index 99) to surface the true max; with only
    // ONE outlier among 100 samples, p99 lands one sample short of it. This
    // is the correct, well-known nearest-rank behavior (not a smoothed/
    // interpolated percentile) — asserting it directly here pins down which
    // convention `percentile()` implements.
    for (let i = 0; i < 90; i++) buf.record({ durationMs: 10, status: 200, method: 'GET', route: '/x' });
    for (let i = 0; i < 9; i++) buf.record({ durationMs: 100, status: 200, method: 'GET', route: '/x' });
    buf.record({ durationMs: 1000, status: 200, method: 'GET', route: '/x' });
    const snap = buf.snapshot();
    expect(snap.p50).toBe(10);
    expect(snap.p95).toBe(100);
    expect(snap.p99).toBe(100);
  });
});
