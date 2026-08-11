// Vendored from Animate UI (https://animate-ui.com), registry item
// "hooks-use-controlled-state". Same upstream reference/license as
// components/animate-ui/primitives/radix/dialog.tsx.
//
// LOCAL PATCH (Solytiq): the upstream implementation stored the controlled
// `value` in local state and re-synced it via a `useEffect`
// (`if (value !== undefined) setInternalState(value)`), which this project's
// `react-hooks/set-state-in-effect` rule correctly flags — syncing a prop
// into state via an effect causes an extra render on every controlled-value
// change and is exactly the "you might not need an effect" pattern React's
// own docs warn about. Rewritten to derive the current value directly during
// render (`isControlled ? value : uncontrolledState`) — the standard
// controlled/uncontrolled hook shape (this is also how Radix's own
// `useControllableState` works), functionally identical for every caller but
// with no effect and no extra render.
import * as React from 'react';

interface CommonControlledStateProps<T> {
  value?: T;
  defaultValue?: T;
}

export function useControlledState<T, Rest extends unknown[] = []>(
  props: CommonControlledStateProps<T> & {
    onChange?: (value: T, ...args: Rest) => void;
  },
): readonly [T, (next: T, ...args: Rest) => void] {
  const { value, defaultValue, onChange } = props;
  const isControlled = value !== undefined;

  const [uncontrolledState, setUncontrolledState] = React.useState<T>(
    defaultValue as T,
  );

  const state = isControlled ? value : uncontrolledState;

  const setState = React.useCallback(
    (next: T, ...args: Rest) => {
      if (!isControlled) setUncontrolledState(next);
      onChange?.(next, ...args);
    },
    [isControlled, onChange],
  );

  return [state, setState] as const;
}
