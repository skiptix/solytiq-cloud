// ---------------------------------------------------------------------------
// B8 — graceful shutdown sequencing. Fully mocked deps (fake server/pool/
// timers), no real process, no real sleeps for the full deadline.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetShutdownStateForTests, isShuttingDown, runGracefulShutdown, type ShutdownDeps } from '../shutdown';

function fakeServer(closeDelayMs = 0) {
  return {
    close: (cb: () => void) => {
      if (closeDelayMs === 0) cb();
      else setTimeout(cb, closeDelayMs);
    },
  };
}

function fakePool() {
  const ended = { value: false };
  return { ended, pool: { end: async () => { ended.value = true; } } };
}

beforeEach(() => {
  __resetShutdownStateForTests();
});
afterEach(() => {
  __resetShutdownStateForTests();
  vi.restoreAllMocks();
});

describe('isShuttingDown / runGracefulShutdown', () => {
  it('isShuttingDown() is false before any shutdown signal', () => {
    expect(isShuttingDown()).toBe(false);
  });

  it('flips isShuttingDown() to true synchronously as the FIRST effect, before any async drain step', async () => {
    const { pool } = fakePool();
    const order: string[] = [];
    const deps: ShutdownDeps = {
      server: fakeServer(),
      pool,
      timers: [],
      closeSse: () => { order.push('closeSse'); expect(isShuttingDown()).toBe(true); },
      log: () => {},
    };
    const p = runGracefulShutdown('SIGTERM', deps);
    // Even before awaiting, the flag must already be true — a concurrent
    // /readyz check racing this exact tick must see shutdown=true, never a
    // stale "still ready" read.
    expect(isShuttingDown()).toBe(true);
    await p;
    expect(order).toEqual(['closeSse']);
  });

  it('runs the full sequence in order: timers cleared -> leases released -> SSE closed -> dispatcher stopped -> server closed -> pool ended', async () => {
    const order: string[] = [];
    const { pool } = fakePool();
    const timer = setInterval(() => {}, 100_000); // never actually fires in test lifetime
    const deps: ShutdownDeps = {
      server: { close: (cb: () => void) => { order.push('server.close'); cb(); } },
      pool: { end: async () => { order.push('pool.end'); } },
      timers: [timer],
      releaseOwnedLeases: async () => { order.push('releaseOwnedLeases'); },
      closeSse: () => order.push('closeSse'),
      stopSyncDispatcher: async () => { order.push('stopSyncDispatcher'); },
      log: () => {},
    };
    await runGracefulShutdown('SIGTERM', deps);
    expect(order).toEqual(['releaseOwnedLeases', 'closeSse', 'stopSyncDispatcher', 'server.close', 'pool.end']);
  });

  it('B8: releaseOwnedLeases is optional — a deps object without it (e.g. an api-role process, which never holds either lease table\'s rows) drains normally', async () => {
    const order: string[] = [];
    const { pool } = fakePool();
    await runGracefulShutdown('SIGTERM', {
      server: { close: (cb: () => void) => { order.push('server.close'); cb(); } },
      pool: { end: async () => { order.push('pool.end'); } },
      timers: [],
      closeSse: () => order.push('closeSse'),
      log: () => {},
    });
    expect(order).toEqual(['closeSse', 'server.close', 'pool.end']);
  });

  it('B8: a releaseOwnedLeases throw does not prevent the rest of the drain (matches the existing closeSse-throw resilience test below)', async () => {
    const { pool, ended } = fakePool();
    await runGracefulShutdown('SIGTERM', {
      server: fakeServer(),
      pool,
      timers: [],
      releaseOwnedLeases: async () => { throw new Error('boom — DB unreachable mid-shutdown'); },
      log: () => {},
    });
    expect(ended.value).toBe(true); // the rest of the drain (pool.end) still completed
  });

  it('clears every timer handle passed in (no sweep can fire after shutdown starts)', async () => {
    const clearSpy = vi.spyOn(global, 'clearInterval');
    const { pool } = fakePool();
    const t1 = setInterval(() => {}, 100_000);
    const t2 = setInterval(() => {}, 100_000);
    await runGracefulShutdown('SIGTERM', { server: fakeServer(), pool, timers: [t1, t2], log: () => {} });
    expect(clearSpy).toHaveBeenCalledWith(t1);
    expect(clearSpy).toHaveBeenCalledWith(t2);
  });

  it('is idempotent — a second signal while already draining does not re-run the sequence', async () => {
    let sseCloseCount = 0;
    const { pool, ended } = fakePool();
    const deps: ShutdownDeps = {
      server: fakeServer(20),
      pool,
      timers: [],
      closeSse: () => { sseCloseCount += 1; },
      log: () => {},
    };
    const first = runGracefulShutdown('SIGTERM', deps);
    const second = runGracefulShutdown('SIGINT', deps); // arrives while first is still draining
    await Promise.all([first, second]);
    expect(sseCloseCount).toBe(1);
    expect(ended.value).toBe(true);
  });

  it('force-exits once the deadline elapses, even if the drain never finishes on its own', async () => {
    let exitCode: number | null = null;
    const hangingServer = { close: () => { /* never calls back — simulates a request that never completes */ } };
    const { pool } = fakePool();
    const started = Date.now();
    await runGracefulShutdown('SIGTERM', {
      server: hangingServer,
      pool,
      timers: [],
      deadlineMillis: 50,
      exit: (code) => { exitCode = code; },
      log: () => {},
    });
    const elapsed = Date.now() - started;
    expect(exitCode).toBe(1);
    expect(elapsed).toBeLessThan(1000); // bounded by the deadline, not the hang
  });

  it('a slow-but-finite drain that finishes before the deadline does NOT force-exit', async () => {
    let exitCalled = false;
    const { pool } = fakePool();
    await runGracefulShutdown('SIGTERM', {
      server: fakeServer(10),
      pool,
      timers: [],
      deadlineMillis: 5_000,
      exit: () => { exitCalled = true; },
      log: () => {},
    });
    expect(exitCalled).toBe(false);
  });

  it('a closeSse throw does not prevent the rest of the drain (pool still closes)', async () => {
    const { pool, ended } = fakePool();
    await runGracefulShutdown('SIGTERM', {
      server: fakeServer(),
      pool,
      timers: [],
      closeSse: () => { throw new Error('boom'); },
      log: () => {},
    });
    expect(ended.value).toBe(true);
  });
});
