/**
 * Regression: media seek over the proxy. A <video>/<audio> element issues
 * `Range` requests; the runtime answers with `206 Partial Content` +
 * `Content-Range`/`Accept-Ranges`. The proxy MUST (1) forward the client's
 * `Range` request header to the runner, and (2) allowlist the runner's
 * range/partial response headers — otherwise the browser gets a 206 with no
 * Content-Range and playback fails (the "loaded but could not be displayed"
 * symptom on non-faststart MP4s).
 */

import { mock } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import {
  MockTunnelTimeoutError,
  createRunnerResolverMock,
  createWsRelayMock,
} from '../helpers/proxy-test-mocks.js';

// Runner connected → tunnel is the primary transport.
mock.module('../../services/ws-relay.js', () => createWsRelayMock(() => true));

let capturedHeaders: Record<string, string> = {};

mock.module('../../services/ws-tunnel.js', () => ({
  setIO: () => {},
  TunnelTimeoutError: MockTunnelTimeoutError,
  isTunnelTimeoutError: () => false,
  tunnelFetch: async (_runnerId: string, req: { headers: Record<string, string> }) => {
    capturedHeaders = req.headers;
    return {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-range': 'bytes 0-1/10',
        'accept-ranges': 'bytes',
        'content-length': '2',
        // NOT on the allowlist — must still be dropped (Security M5 unchanged).
        'set-cookie': 'session=leak',
      },
      body: Buffer.from([0x00, 0x01]).toString('base64'),
      bodyEncoding: 'base64',
    };
  },
}));

mock.module('../../services/runner-resolver.js', () => createRunnerResolverMock());

import { afterEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { proxyToRunner } from '../../middleware/proxy.js';

function makeApp() {
  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    c.set('userRole', 'admin');
    return next();
  });
  app.all('/api/*', proxyToRunner);
  return app;
}

afterEach(() => {
  capturedHeaders = {};
});

describe('proxyToRunner — Range / partial-content forwarding', () => {
  test('forwards the client Range request header to the runner', async () => {
    await makeApp().request('/api/files/raw?path=%2Fp1%2Fclip.mp4', {
      headers: { Range: 'bytes=0-1' },
    });
    expect(capturedHeaders.range).toBe('bytes=0-1');
  });

  test('passes the runner 206 + Accept-Ranges/Content-Range through to the browser', async () => {
    const res = await makeApp().request('/api/files/raw?path=%2Fp1%2Fclip.mp4', {
      headers: { Range: 'bytes=0-1' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-1/10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    // The unrelated, non-allowlisted header is still stripped.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('omits Range when the client did not send one (plain GET still 200s)', async () => {
    await makeApp().request('/api/files/raw?path=%2Fp1%2Fclip.mp4');
    expect(capturedHeaders.range).toBeUndefined();
  });
});
