import { useEffect, useState } from 'react';

/**
 * A clock value that refreshes on an interval, for UI that answers "how long
 * ago was this?".
 *
 * Calling `Date.now()` straight from a render body is impure: the same props
 * render differently depending on when React happened to run, which is what
 * `react-hooks/purity` flags. It is also wrong in a quieter way — a
 * "last seen 3m ago" label or an online dot computed that way only updates
 * when something ELSE re-renders the list, so it can sit at "3m ago" for an
 * hour and then jump.
 *
 * Reading the clock through state fixes both: renders are deterministic in
 * their inputs, and the label actually ticks.
 */
export default function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
