import { afterEach, describe, expect, test } from 'bun:test';

import { serveExclusive } from '../../hosts/bun/listen.js';

const fetch = () => new Response('ok');

describe('serveExclusive', () => {
  const servers: Array<{ stop(force?: boolean): unknown }> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
  });

  // Regression for #232: with `reusePort: true` a second funny-server on the
  // same port bound silently and ran a second automation cron.
  test('a second listener on the same port fails with EADDRINUSE', () => {
    const first = serveExclusive({ port: 0, hostname: '127.0.0.1', fetch });
    servers.push(first);
    const port = first.port!;

    let error: unknown;
    try {
      servers.push(serveExclusive({ port, hostname: '127.0.0.1', fetch }));
    } catch (e) {
      error = e;
    }
    expect((error as { code?: string } | undefined)?.code).toBe('EADDRINUSE');
  });

  test('ignores a caller-supplied reusePort', () => {
    const first = serveExclusive({ port: 0, hostname: '127.0.0.1', fetch, reusePort: true });
    servers.push(first);
    expect(() =>
      servers.push(
        serveExclusive({ port: first.port!, hostname: '127.0.0.1', fetch, reusePort: true }),
      ),
    ).toThrow();
  });
});
