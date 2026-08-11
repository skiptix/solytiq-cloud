// @vitest-environment jsdom
// Regression test for the Sprint 03 Animate-UI-Kompatibilitäts-Spike local
// patch to useControlledState: the vendored upstream implementation synced
// a controlled `value` prop into local state via a `useEffect`
// (`react-hooks/set-state-in-effect` — flagged by this project's lint
// config), which was rewritten to derive the current value directly during
// render instead. This test locks in that both the controlled and
// uncontrolled behavior are unchanged by the rewrite — the exact contract
// every Animate UI primitive built on this hook (Dialog, Switch, Tabs, ...)
// relies on.
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useControlledState } from '../use-controlled-state';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
}

describe('useControlledState', () => {
  it('uncontrolled: starts at defaultValue and updates locally on setState', () => {
    let latest: [boolean, (v: boolean) => void] | null = null;
    function Probe() {
      const [checked, setChecked] = useControlledState<boolean>({ defaultValue: false });
      latest = [checked, setChecked];
      return null;
    }
    mount(<Probe />);
    expect(latest![0]).toBe(false);

    act(() => latest![1](true));
    expect(latest![0]).toBe(true);
  });

  it('controlled: always reflects the `value` prop, ignoring local setState for its own state (parent decides)', () => {
    let latest: [boolean, (v: boolean) => void] | null = null;
    const onChangeCalls: boolean[] = [];
    function Probe({ value }: { value: boolean }) {
      const [checked, setChecked] = useControlledState<boolean>({
        value,
        onChange: (v) => onChangeCalls.push(v),
      });
      latest = [checked, setChecked];
      return null;
    }
    mount(<Probe value={false} />);
    expect(latest![0]).toBe(false);

    // Calling the returned setState in controlled mode must NOT flip local
    // state on its own — it only reports the change via onChange, exactly
    // like a real controlled <input>. The parent re-renders with a new
    // `value` prop to actually change what's displayed.
    act(() => latest![1](true));
    expect(onChangeCalls).toEqual([true]);
    expect(latest![0]).toBe(false); // unchanged until the parent passes value=true

    mount(<Probe value={true} />);
    expect(latest![0]).toBe(true);
  });

  it('controlled: value updates propagate synchronously on the next render (no stale frame from a sync-via-effect)', () => {
    // This is the specific regression the rewrite targets: the original
    // implementation stored `value` in state and re-synced via a
    // useEffect, which (under React's effect timing) could not guarantee
    // the derived value was correct on the very same render `value`
    // changed. Deriving `isControlled ? value : uncontrolledState` directly
    // during render eliminates that class of bug entirely.
    const renderedValues: number[] = [];
    function Probe({ value }: { value: number }) {
      const [n] = useControlledState<number>({ value });
      renderedValues.push(n);
      return null;
    }
    mount(<Probe value={1} />);
    act(() => root!.render(<Probe value={2} />));
    act(() => root!.render(<Probe value={3} />));
    expect(renderedValues).toEqual([1, 2, 3]);
  });
});
