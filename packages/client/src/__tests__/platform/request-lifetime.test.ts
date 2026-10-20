import { describe, expect, test, vi } from 'vitest';

import {
  createBrowserTransportService,
  resolveWebEnvironment,
} from '@/platform/web/browser-transport';
import { createRequestLifetime } from '@/platform/web/request-lifetime';

describe('browser request lifetime', () => {
  test('aborts pending fetches on page exit, blocks new ones, and resumes on bfcache restore', async () => {
    const target = new EventTarget();
    const lifetime = createRequestLifetime(target);
    const report = vi.fn();
    const fetcher = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new TypeError('Failed to fetch')));
        }),
    );
    const transport = createBrowserTransportService(
      resolveWebEnvironment({ isTauri: false, pageOrigin: 'http://localhost' }),
      fetcher,
      { report },
      lifetime.signal,
    );
    const pending = transport.request({ url: '/api/projects' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    target.dispatchEvent(new Event('pagehide'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(transport.request({ url: '/api/threads' })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
    target.dispatchEvent(new Event('pageshow'));
    fetcher.mockResolvedValueOnce(new Response('{}'));
    expect((await transport.request({ url: '/api/projects' })).ok).toBe(true);
    lifetime.dispose();
  });

  test('module disposal aborts requests and removes lifecycle listeners', () => {
    const target = new EventTarget();
    const remove = vi.spyOn(target, 'removeEventListener');
    const lifetime = createRequestLifetime(target);
    const signal = lifetime.signal();
    lifetime.dispose();
    expect(signal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledTimes(2);
    target.dispatchEvent(new Event('pageshow'));
    expect(lifetime.signal().aborted).toBe(true);
  });
});
