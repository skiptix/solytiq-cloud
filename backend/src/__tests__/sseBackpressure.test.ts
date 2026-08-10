// ---------------------------------------------------------------------------
// B7 (Phase 2) — SSE backpressure, bounded queue, and connection-limit unit
// tests. Zero DB dependency — addSseClient/broadcastToUser(s) are pure
// in-memory (sweepStaleSseConnections' max-age check IS DB-touching and is
// instead proven in sseRevocation.integration.test.ts against a live DB).
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addSseClient, removeSseClient, broadcastToUser, broadcastToUsers,
  __sseConnectionCountForTests, __clearAllSseClientsForTests, __getSseQueueStateForTests,
} from '../sse';
import { SSE_MAX_CONNECTIONS_PER_USER, SSE_MAX_QUEUE_BYTES } from '../sseConfig';

/** A minimal, controllable stand-in for express.Response — a real
 *  EventEmitter (so `.once('drain', cb)` genuinely works) with a `write()`
 *  whose return value the test controls, so backpressure can be simulated
 *  deterministically without a real slow socket. */
class FakeRes extends EventEmitter {
  written: string[] = [];
  ended = false;
  /** When true, the NEXT write() call returns false (simulating a full
   *  buffer) and every subsequent write() also returns false until
   *  `unblock()` is called. */
  private blocked = false;

  write(data: string): boolean {
    if (this.ended) throw new Error('write after end');
    this.written.push(data);
    return !this.blocked;
  }
  end(): void {
    this.ended = true;
  }
  block(): void {
    this.blocked = true;
  }
  /** Unblocks writes AND emits 'drain' — mirrors what Node's real socket
   *  does once its buffer empties. */
  unblock(): void {
    this.blocked = false;
    this.emit('drain');
  }
}

afterEach(() => {
  __clearAllSseClientsForTests();
});

describe('SSE backpressure — bounded queue, drain, overflow drop', () => {
  it('writes directly (no queueing) when the client is keeping up', () => {
    const userId = 'u1';
    const res = new FakeRes();
    addSseClient(userId, res as unknown as Parameters<typeof addSseClient>[1], 0);
    broadcastToUser(userId, 'lists');
    expect(res.written.length).toBe(1);
    expect(__getSseQueueStateForTests(userId)[0]).toEqual({ paused: false, queuedBytes: 0, queueLength: 0 });
  });

  it('buffers subsequent frames once write() returns false (backpressure), instead of dropping or blocking', () => {
    const userId = 'u2';
    const res = new FakeRes();
    addSseClient(userId, res as unknown as Parameters<typeof addSseClient>[1], 0);

    res.block();
    broadcastToUser(userId, 'lists'); // write() returns false -> client becomes paused
    let state = __getSseQueueStateForTests(userId)[0];
    expect(state.paused).toBe(true);

    broadcastToUser(userId, 'tasks'); // now buffered, not written directly
    broadcastToUser(userId, 'folders');
    state = __getSseQueueStateForTests(userId)[0];
    expect(state.queueLength).toBe(2);
    expect(state.queuedBytes).toBeGreaterThan(0);
    // Only the FIRST write (before blocking) actually reached the socket.
    expect(res.written.length).toBe(1);
  });

  it('flushes the buffered queue in FIFO order once the socket drains', () => {
    const userId = 'u3';
    const res = new FakeRes();
    addSseClient(userId, res as unknown as Parameters<typeof addSseClient>[1], 0);

    res.block();
    broadcastToUser(userId, 'first');  // write() is still attempted (and "sent") even though it returns false — that's what triggers pausing
    broadcastToUser(userId, 'second'); // now buffered (already paused)
    broadcastToUser(userId, 'third');  // buffered
    expect(res.written.length).toBe(1); // only 'first' reached the socket so far
    expect(__getSseQueueStateForTests(userId)[0].queueLength).toBe(2); // 'second' + 'third' queued

    res.unblock();
    // flushSseQueue runs synchronously off the 'drain' event.
    expect(res.written.length).toBe(3); // 'first' (direct) + 'second' + 'third' (flushed)
    expect(__getSseQueueStateForTests(userId)[0]).toEqual({ paused: false, queuedBytes: 0, queueLength: 0 });
  });

  it('never exceeds SSE_MAX_QUEUE_BYTES — a client that stays backed up past the budget is dropped, not held onto indefinitely', () => {
    const userId = 'u4';
    const res = new FakeRes();
    addSseClient(userId, res as unknown as Parameters<typeof addSseClient>[1], 0);

    res.block();
    broadcastToUser(userId, 'prime-the-pause'); // first write triggers pause

    // Push frames until the queue would exceed the byte budget. Each
    // broadcastToUser call enqueues one JSON frame; feed enough that their
    // cumulative size must cross SSE_MAX_QUEUE_BYTES well before this loop
    // ends (frames are small, ~40 bytes each, so this needs many).
    const bigEventName = 'x'.repeat(2000); // inflate each frame's size
    let droppedAt = -1;
    for (let i = 0; i < 1000; i++) {
      broadcastToUser(userId, bigEventName + i);
      if (__sseConnectionCountForTests(userId) === 0) { droppedAt = i; break; }
    }

    expect(droppedAt).toBeGreaterThanOrEqual(0); // the connection WAS dropped at some point
    expect(res.ended).toBe(true); // and its response was actually ended, not just forgotten
    expect(__sseConnectionCountForTests(userId)).toBe(0);
  });

  it('a queue that stays comfortably under the budget is never dropped', () => {
    const userId = 'u5';
    const res = new FakeRes();
    addSseClient(userId, res as unknown as Parameters<typeof addSseClient>[1], 0);
    res.block();
    for (let i = 0; i < 5; i++) broadcastToUser(userId, `evt${i}`);
    expect(__sseConnectionCountForTests(userId)).toBe(1);
    const state = __getSseQueueStateForTests(userId)[0];
    expect(state.queuedBytes).toBeLessThan(SSE_MAX_QUEUE_BYTES);
  });

  it('broadcastToUsers fans a frame out to multiple users, each with independent backpressure state', () => {
    const resA = new FakeRes();
    const resB = new FakeRes();
    addSseClient('ua', resA as unknown as Parameters<typeof addSseClient>[1], 0);
    addSseClient('ub', resB as unknown as Parameters<typeof addSseClient>[1], 0);
    resA.block(); // A is backed up, B is not

    broadcastToUsers(['ua', 'ub'], { cursor: 1, entities: [], workspaceId: null });

    expect(__getSseQueueStateForTests('ua')[0].paused).toBe(true);
    expect(__getSseQueueStateForTests('ub')[0].paused).toBe(false);
    expect(resB.written.length).toBe(1);
  });

  it('a write() that throws (socket already destroyed) drops the client instead of propagating', () => {
    const userId = 'u6';
    const res = new FakeRes();
    (res as unknown as { write: () => boolean }).write = () => { throw new Error('EPIPE'); };
    addSseClient(userId, res as unknown as Parameters<typeof addSseClient>[1], 0);
    expect(() => broadcastToUser(userId, 'evt')).not.toThrow();
    expect(__sseConnectionCountForTests(userId)).toBe(0);
  });
});

describe('SSE connection limit — configurable, defaults to the B7 spec value', () => {
  it('SSE_MAX_CONNECTIONS_PER_USER defaults to 5 (the literal B7 gate value)', () => {
    expect(SSE_MAX_CONNECTIONS_PER_USER).toBe(5);
  });

  it('the (N+1)th connection evicts the OLDEST rather than being hard-rejected — user is never fully locked out', () => {
    const userId = 'u7';
    const resList: FakeRes[] = [];
    for (let i = 0; i < SSE_MAX_CONNECTIONS_PER_USER; i++) {
      const res = new FakeRes();
      resList.push(res);
      addSseClient(userId, res as unknown as Parameters<typeof addSseClient>[1], 0);
    }
    expect(__sseConnectionCountForTests(userId)).toBe(SSE_MAX_CONNECTIONS_PER_USER);

    // The (N+1)th connection — the oldest (resList[0]) must be evicted.
    const newRes = new FakeRes();
    addSseClient(userId, newRes as unknown as Parameters<typeof addSseClient>[1], 0);

    expect(__sseConnectionCountForTests(userId)).toBe(SSE_MAX_CONNECTIONS_PER_USER); // still bounded, not grown
    expect(resList[0].ended).toBe(true); // the oldest was closed
    expect(newRes.ended).toBe(false); // the new one survives
  });

  it('removeSseClient cleans up an empty user entry entirely', () => {
    const userId = 'u8';
    const res = new FakeRes();
    addSseClient(userId, res as unknown as Parameters<typeof addSseClient>[1], 0);
    removeSseClient(userId, res as unknown as Parameters<typeof addSseClient>[1]);
    expect(__sseConnectionCountForTests(userId)).toBe(0);
  });
});
