// @vitest-environment jsdom
//
// useFrameLoop is the central layer's only sanctioned per-frame callback, so
// the two decisions it encodes have to be locked in:
//
//   1. `reducedMotion: 'stop'` really stops. Decoration that keeps running
//      for a user who asked it not to is the failure this whole gate exists
//      to prevent.
//   2. `reducedMotion: 'settle'` does NOT stop — it runs and then stops. A
//      force simulation is how node positions are COMPUTED; a sim that never
//      ticks renders every node stacked at the origin, which is a broken
//      screen, not a calmer one. This distinction is easy to "simplify" away
//      later by someone who reads both modes as the same intent.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import useFrameLoop from '../useFrameLoop';

// Fake timers are installed ONCE for the whole file and never torn down
// between tests. Motion's frame scheduler is a module-level singleton with its
// own monotonic clock; swapping back to real timers and re-faking resets the
// fake clock to 0, so Motion sees a timestamp jump backwards and stops
// scheduling. That produced a "reduced motion suppresses everything" result
// that was purely a harness artefact.
beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
});
afterAll(() => { vi.useRealTimers(); });

let reduce = false;
vi.mock('../motion', async () => {
  const actual = await vi.importActual<typeof import('../motion')>('../motion');
  return { ...actual, useReducedMotion: () => reduce };
});

/** Drives however many rAF frames Motion has queued, `ms` apart. */
async function runFrames(count: number, ms = 16) {
  for (let i = 0; i < count; i++) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
    });
  }
}

function mount(ui: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(ui); });
  return () => act(() => { root.unmount(); });
}

afterEach(() => { reduce = false; });

describe('useFrameLoop', () => {
  it('calls back once per frame while running', async () => {
    const tick = vi.fn();
    function Probe() { useFrameLoop(tick); return null; }
    const unmount = mount(<Probe />);
    await runFrames(4);
    expect(tick.mock.calls.length).toBeGreaterThan(0);
    unmount();
  });

  it('does not call back when running is false', async () => {
    const tick = vi.fn();
    function Probe() { useFrameLoop(tick, { running: false }); return null; }
    const unmount = mount(<Probe />);
    await runFrames(4);
    expect(tick).not.toHaveBeenCalled();
    unmount();
  });

  it("reducedMotion 'stop' suppresses the callback entirely", async () => {
    reduce = true;
    const tick = vi.fn();
    function Probe() { useFrameLoop(tick, { reducedMotion: 'stop' }); return null; }
    const unmount = mount(<Probe />);
    await runFrames(6);
    expect(tick).not.toHaveBeenCalled();
    unmount();
  });

  it("reducedMotion 'settle' still runs — it is layout, not decoration", async () => {
    reduce = true;
    const tick = vi.fn();
    function Probe() { useFrameLoop(tick, { reducedMotion: 'settle', settleMs: 200 }); return null; }
    const unmount = mount(<Probe />);
    await runFrames(4);
    expect(tick.mock.calls.length).toBeGreaterThan(0);
    unmount();
  });

  it("reducedMotion 'settle' stops once the settle window has passed", async () => {
    reduce = true;
    const tick = vi.fn();
    function Probe() { useFrameLoop(tick, { reducedMotion: 'settle', settleMs: 50 }); return null; }
    const unmount = mount(<Probe />);
    await runFrames(4);
    const during = tick.mock.calls.length;
    expect(during).toBeGreaterThan(0);
    // Push well past the settle window, then keep driving frames.
    await runFrames(6, 100);
    const settled = tick.mock.calls.length;
    await runFrames(6, 100);
    expect(tick.mock.calls.length).toBe(settled);
    unmount();
  });
});
