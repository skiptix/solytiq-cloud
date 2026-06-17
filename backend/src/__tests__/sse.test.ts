import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addSseClient, removeSseClient, broadcastToUser } from '../sse';
import type { Response } from 'express';

function mockRes(): Response {
  return { write: vi.fn() } as unknown as Response;
}

// The module uses a module-level Map, so tests interact with shared state.
// We use unique user IDs per test to avoid interference.

describe('addSseClient / removeSseClient', () => {
  it('registers a client and allows removal', () => {
    const res = mockRes();
    addSseClient('sse-user-1', res);
    // Broadcasting should reach the client
    broadcastToUser('sse-user-1', 'lists');
    expect(res.write).toHaveBeenCalledTimes(1);

    removeSseClient('sse-user-1', res);
    // After removal, broadcast should not reach it
    (res.write as ReturnType<typeof vi.fn>).mockClear();
    broadcastToUser('sse-user-1', 'lists');
    expect(res.write).not.toHaveBeenCalled();
  });

  it('supports multiple clients per user', () => {
    const r1 = mockRes();
    const r2 = mockRes();
    addSseClient('sse-user-2', r1);
    addSseClient('sse-user-2', r2);

    broadcastToUser('sse-user-2', 'files');
    expect(r1.write).toHaveBeenCalledTimes(1);
    expect(r2.write).toHaveBeenCalledTimes(1);
  });

  it('removing a non-existent client is a no-op', () => {
    const res = mockRes();
    // Should not throw
    removeSseClient('sse-user-never', res);
  });
});

describe('broadcastToUser', () => {
  it('sends an SSE-formatted payload with the event type', () => {
    const res = mockRes();
    addSseClient('sse-user-3', res);

    broadcastToUser('sse-user-3', 'timelines');

    const written = (res.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain('event: sync');
    expect(written).toContain('"type":"timelines"');
    expect(written.endsWith('\n\n')).toBe(true);
  });

  it('silently skips users with no connected clients', () => {
    // Should not throw
    broadcastToUser('sse-user-ghost', 'lists');
  });

  it('removes a client that throws on write', () => {
    const good = mockRes();
    const bad = mockRes();
    (bad.write as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('closed'); });

    addSseClient('sse-user-4', good);
    addSseClient('sse-user-4', bad);

    broadcastToUser('sse-user-4', 'tasks');
    expect(good.write).toHaveBeenCalledTimes(1);

    // Second broadcast should only reach `good` (bad was removed)
    (good.write as ReturnType<typeof vi.fn>).mockClear();
    broadcastToUser('sse-user-4', 'tasks');
    expect(good.write).toHaveBeenCalledTimes(1);
    // bad.write was called once in the first broadcast attempt, then removed
    expect(bad.write).toHaveBeenCalledTimes(1);
  });
});
