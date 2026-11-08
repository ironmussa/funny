import { describe, expect, test, vi } from 'vitest';

import { createLatestFrameFetcher } from './latest-frame-fetcher';

function deferredFetch() {
  const calls: Array<{ url: string; resolve: (data: string) => void }> = [];
  const fetch = vi.fn(
    (url: string) => new Promise<string>((resolve) => calls.push({ url, resolve })),
  );
  return { fetch, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createLatestFrameFetcher', () => {
  test('fetches one frame at a time per session and skips the ones in between', async () => {
    const { fetch, calls } = deferredFetch();
    const deliver = vi.fn();
    const frames = createLatestFrameFetcher({ fetch, deliver, onError: vi.fn() });

    for (const n of [1, 2, 3, 4]) frames.push('s1', `/f${n}`);
    expect(calls.map((c) => c.url)).toEqual(['/f1']);

    calls[0].resolve('one');
    await tick();
    // Only the newest waiting frame is fetched next.
    expect(calls.map((c) => c.url)).toEqual(['/f1', '/f4']);
    calls[1].resolve('four');
    await tick();

    expect(deliver.mock.calls).toEqual([
      ['s1', 'one'],
      ['s1', 'four'],
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('sessions do not wait on each other', () => {
    const { calls, fetch } = deferredFetch();
    const frames = createLatestFrameFetcher({ fetch, deliver: vi.fn(), onError: vi.fn() });
    frames.push('s1', '/a');
    frames.push('s2', '/b');
    expect(calls.map((c) => c.url)).toEqual(['/a', '/b']);
  });

  test('a failed fetch is reported and the next frame still loads', async () => {
    const onError = vi.fn();
    const deliver = vi.fn();
    const fetch = vi
      .fn<(url: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce('ok');
    const frames = createLatestFrameFetcher({ fetch, deliver, onError });
    frames.push('s1', '/gone');
    frames.push('s1', '/next');
    await tick();
    await tick();
    expect(onError).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith('s1', 'ok');
  });
});
