// @vitest-environment jsdom
//
// The behaviours this hook exists to guarantee — each one is something a call
// site previously hand-rolled and could get subtly wrong:
//
//   1. Changing the key clears the previous key's data IMMEDIATELY, in the
//      same render. That is the whole reason the old effects called setState
//      synchronously; if the derived version has even a one-render gap, the
//      hook is worse than what it replaced.
//   2. An out-of-order response cannot overwrite a newer one.
//   3. `enabled: false` / a null key loads nothing and shows `initial`.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import useAsyncData from '../useAsyncData';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

/** Renders `ui` and returns a re-render + unmount handle. */
function mount(render: () => React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(render()); });
  return {
    rerender: (next: () => React.ReactElement) => act(() => { root.render(next()); }),
    unmount: () => act(() => { root.unmount(); }),
  };
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('useAsyncData', () => {
  it('starts loading with the initial value, then settles', async () => {
    const seen: Array<{ data: string[]; loading: boolean }> = [];
    function Probe({ id }: { id: string }) {
      const { data, loading } = useAsyncData(id, async () => [`for-${id}`], [] as string[]);
      seen.push({ data, loading });
      return null;
    }
    const h = mount(() => <Probe id="a" />);
    expect(seen[0]).toEqual({ data: [], loading: true });
    await flush();
    expect(seen[seen.length - 1]).toEqual({ data: ['for-a'], loading: false });
    h.unmount();
  });

  it('clears the previous key\'s data in the SAME render the key changes', async () => {
    const seen: Array<{ data: string[]; loading: boolean }> = [];
    function Probe({ id }: { id: string }) {
      const { data, loading } = useAsyncData(id, async () => [`for-${id}`], [] as string[]);
      seen.push({ data, loading });
      return null;
    }
    const h = mount(() => <Probe id="a" />);
    await flush();
    expect(seen[seen.length - 1].data).toEqual(['for-a']);

    seen.length = 0;
    h.rerender(() => <Probe id="b" />);
    // The very first render under the new key must NOT still show a's data.
    expect(seen[0]).toEqual({ data: [], loading: true });
    await flush();
    expect(seen[seen.length - 1]).toEqual({ data: ['for-b'], loading: false });
    h.unmount();
  });

  it('discards a stale response that resolves after a newer one', async () => {
    const resolvers: Record<string, (v: string[]) => void> = {};
    const seen: string[][] = [];
    function Probe({ id }: { id: string }) {
      const { data } = useAsyncData(
        id,
        () => new Promise<string[]>((res) => { resolvers[id] = res; }),
        [] as string[]
      );
      seen.push(data);
      return null;
    }
    const h = mount(() => <Probe id="slow" />);
    h.rerender(() => <Probe id="fast" />);

    await act(async () => { resolvers.fast(['fast-result']); await Promise.resolve(); });
    expect(seen[seen.length - 1]).toEqual(['fast-result']);

    // The abandoned request now comes back. It must not win.
    await act(async () => { resolvers.slow(['slow-result']); await Promise.resolve(); });
    expect(seen[seen.length - 1]).toEqual(['fast-result']);
    h.unmount();
  });

  it('does not fetch when disabled, and shows initial', async () => {
    const fetcher = vi.fn(async () => ['x']);
    function Probe() {
      const { data, loading } = useAsyncData('k', fetcher, [] as string[], { enabled: false });
      return <span data-testid="out">{`${loading}:${data.join(',')}`}</span>;
    }
    const h = mount(() => <Probe />);
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="out"]')?.textContent).toBe('false:');
    h.unmount();
  });

  it('does not fetch for a null key', async () => {
    const fetcher = vi.fn(async () => ['x']);
    function Probe() {
      useAsyncData(null, fetcher, [] as string[]);
      return null;
    }
    const h = mount(() => <Probe />);
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    h.unmount();
  });

  it('compares object keys by value, not reference', async () => {
    const fetcher = vi.fn(async () => ['x']);
    function Probe({ n }: { n: number }) {
      // A fresh object literal every render — reference identity would refetch
      // forever, which is the trap this hook has to avoid.
      useAsyncData({ a: 1, b: n }, fetcher, [] as string[]);
      return null;
    }
    const h = mount(() => <Probe n={1} />);
    await flush();
    h.rerender(() => <Probe n={1} />);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    h.rerender(() => <Probe n={2} />);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    h.unmount();
  });

  it('surfaces an error and stops loading', async () => {
    function Probe() {
      const { error, loading } = useAsyncData('k', async () => { throw new Error('boom'); }, null);
      return <span data-testid="out">{`${loading}:${(error as Error | null)?.message ?? ''}`}</span>;
    }
    const h = mount(() => <Probe />);
    await flush();
    expect(document.querySelector('[data-testid="out"]')?.textContent).toBe('false:boom');
    h.unmount();
  });
});

describe('useAsyncData setData', () => {
  it('patches the loaded value in place', async () => {
    function Probe() {
      const { data, setData } = useAsyncData('k', async () => ['a'], [] as string[]);
      return (
        <button data-testid="b" onClick={() => setData((p) => [...p, 'b'])}>{data.join(',')}</button>
      );
    }
    const h = mount(() => <Probe />);
    await flush();
    const btn = document.querySelector('[data-testid="b"]') as HTMLButtonElement;
    expect(btn.textContent).toBe('a');
    await act(async () => { btn.click(); });
    expect((document.querySelector('[data-testid="b"]') as HTMLElement).textContent).toBe('a,b');
    h.unmount();
  });

  it('a local edit does not leak onto the next key', async () => {
    function Probe({ id }: { id: string }) {
      const { data, setData } = useAsyncData(id, async () => [`base-${id}`], [] as string[]);
      return (
        <button data-testid="b" onClick={() => setData((p) => [...p, 'local'])}>{data.join(',')}</button>
      );
    }
    const h = mount(() => <Probe id="a" />);
    await flush();
    await act(async () => { (document.querySelector('[data-testid="b"]') as HTMLButtonElement).click(); });
    expect((document.querySelector('[data-testid="b"]') as HTMLElement).textContent).toBe('base-a,local');

    h.rerender(() => <Probe id="b" />);
    await flush();
    expect((document.querySelector('[data-testid="b"]') as HTMLElement).textContent).toBe('base-b');
    h.unmount();
  });
});
