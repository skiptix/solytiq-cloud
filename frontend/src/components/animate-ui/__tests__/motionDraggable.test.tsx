// @vitest-environment jsdom
//
// Locks in the runtime behaviour MotionDraggable (and therefore every
// native-HTML5-drag list row in the app — Sidebar rows, TaskItem rows,
// GPSMergeWizard's merge-order rows) depends on:
//
//   With Motion's own `drag` prop NOT set, `motion.div` forwards native
//   drag handlers straight to the DOM as ordinary React event handlers.
//
// Motion's TYPES claim these props are pan-gesture callbacks, which is why
// MotionDraggable has to re-type them. If a future Motion upgrade ever makes
// the types honest by actually intercepting these at runtime, this test goes
// red and tells us drag-and-drop is broken — rather than it silently failing
// in the UI, which is exactly how this was nearly mis-migrated.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import MotionDraggable from '../MotionDraggable';

// React only suppresses its "not wrapped in act(...)" warning when the
// environment opts in explicitly; without this every render below logs a
// spurious stderr line that would otherwise train us to ignore real ones.
beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

async function renderRow(props: Record<string, unknown>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MotionDraggable data-testid="row" {...props}>row</MotionDraggable>);
  });
  return host.querySelector('[data-testid="row"]') as HTMLElement;
}

describe('MotionDraggable — native HTML5 drag interop', () => {
  it('keeps the draggable attribute on the rendered DOM node', async () => {
    const el = await renderRow({ draggable: true });
    expect(el.getAttribute('draggable')).toBe('true');
  });

  it('forwards dragstart/dragover/dragleave/drop to the native handlers', async () => {
    const onDragStart = vi.fn();
    const onDragOver = vi.fn();
    const onDragLeave = vi.fn();
    const onDrop = vi.fn();
    const el = await renderRow({ draggable: true, onDragStart, onDragOver, onDragLeave, onDrop });

    await act(async () => {
      for (const type of ['dragstart', 'dragover', 'dragleave', 'drop']) {
        el.dispatchEvent(new Event(type, { bubbles: true }));
      }
    });

    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragOver).toHaveBeenCalledTimes(1);
    expect(onDragLeave).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('passes the NATIVE DOM event, not a Motion PanInfo pair', async () => {
    const onDragStart = vi.fn();
    const el = await renderRow({ draggable: true, onDragStart });
    await act(async () => {
      el.dispatchEvent(new Event('dragstart', { bubbles: true }));
    });
    // Motion's gesture callbacks are (event, info) — a native React handler
    // is called with the synthetic event alone. A defined 2nd argument here
    // would mean Motion has taken the prop over.
    expect(onDragStart.mock.calls[0]?.[1]).toBeUndefined();
    expect(onDragStart.mock.calls[0]?.[0]?.type).toBe('dragstart');
  });

  it('still applies Motion props (animate) alongside native drag', async () => {
    const el = await renderRow({ draggable: true, animate: { opacity: 0.5 }, transition: { duration: 0 } });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(el.style.opacity).toBe('0.5');
  });
});
