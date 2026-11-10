/**
 * The proxy asks the runner transport to stream relayed bodies (`streamBody`)
 * and pipes the chunks to the browser unbuffered. The bytes must arrive exactly,
 * runner headers must still be filtered/neutralized, and the OAuth callback —
 * which parses the body — must keep the buffered path.
 */

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import { createRunnerAccessMock } from '../helpers/proxy-test-mocks.js';

const CHUNKS = [Uint8Array.from([0x89, 0x50, 0xff]), Uint8Array.from([0x00, 0xfe, 0x80])];
const seen: Array<{ path: string; streamBody?: boolean }> = [];

const requests = {
  isAvailable: async () => true,
  request: async (_runnerId: string, request: { path: string; streamBody?: boolean }) => {
    seen.push({ path: request.path, streamBody: request.streamBody });
    return {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'set-cookie': 'session=stolen',
      },
      body: '',
      bodyStream: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of CHUNKS) controller.enqueue(chunk);
          controller.close();
        },
      }),
    };
  },
};

import { beforeEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { createProxyToRunner } from '../../middleware/proxy.js';

function makeApp() {
  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    c.set('userRole', 'admin');
    return next();
  });
  app.all('/api/*', createProxyToRunner({ runnerAccess: createRunnerAccessMock(), requests }));
  return app;
}

describe('proxyToRunner — streamed bodies', () => {
  beforeEach(() => {
    seen.length = 0;
  });

  test('requests a streamed body and relays every byte unchanged', async () => {
    const res = await makeApp().request('/api/files/raw?path=%2Fp1%2Fbig.bin');

    expect(seen[0]).toEqual({ path: '/api/files/raw?path=%2Fp1%2Fbig.bin', streamBody: true });
    expect(res.status).toBe(200);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([
      0x89, 0x50, 0xff, 0x00, 0xfe, 0x80,
    ]);
  });

  test('still filters and neutralizes runner headers on a streamed response', async () => {
    const res = await makeApp().request('/api/files/raw?path=%2Fp1%2Fpage.html');

    expect(res.headers.get('set-cookie')).toBeNull();
    // Active content from a runner is never served as HTML on this origin.
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  });
});
