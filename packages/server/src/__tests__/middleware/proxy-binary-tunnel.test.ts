/**
 * Regression: a binary response (image/video/PDF…) tunneled from a runner must
 * reach the browser byte-for-byte. The runner base64-encodes non-text bodies
 * (`bodyEncoding: 'base64'`) because the Socket.IO ack carries the body as a
 * JSON string and `response.text()` would corrupt the bytes as UTF-8. The proxy
 * must decode that base64 back to raw bytes before responding.
 */

import { mock } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import {
  MockTunnelTimeoutError,
  createRunnerResolverMock,
  createWsRelayMock,
} from '../helpers/proxy-test-mocks.js';

// Runner is connected → tunnel is the primary transport.
mock.module('../../services/ws-relay.js', () => createWsRelayMock(() => true));

// 8 bytes that are NOT valid UTF-8 (lone 0xFF/0xFE etc.) — a UTF-8 round-trip
// would mangle these into replacement chars; base64 preserves them exactly.
const ORIGINAL_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);

let tunnelBodyEncoding: 'utf8' | 'base64' = 'base64';

mock.module('../../services/ws-tunnel.js', () => ({
  setIO: () => {},
  TunnelTimeoutError: MockTunnelTimeoutError,
  isTunnelTimeoutError: () => false,
  tunnelFetch: async () => ({
    status: 200,
    headers: { 'content-type': 'image/png' },
    body:
      tunnelBodyEncoding === 'base64'
        ? Buffer.from(ORIGINAL_BYTES).toString('base64')
        : Buffer.from(ORIGINAL_BYTES).toString('utf8'),
    bodyEncoding: tunnelBodyEncoding,
  }),
}));

mock.module('../../services/runner-resolver.js', () => createRunnerResolverMock());

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

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

describe('proxyToRunner — binary tunnel decode', () => {
  beforeEach(() => {
    tunnelBodyEncoding = 'base64';
  });
  afterEach(() => {
    tunnelBodyEncoding = 'base64';
  });

  test('decodes a base64 tunnel body back to the exact original bytes', async () => {
    const res = await makeApp().request('/api/files/raw?path=%2Fp1%2Fa.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');

    const got = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(ORIGINAL_BYTES));
  });

  test('passes a utf8 tunnel body through unchanged (text path, no decode)', async () => {
    tunnelBodyEncoding = 'utf8';
    const res = await makeApp().request('/api/files/raw?path=%2Fp1%2Fnotes.txt');
    expect(res.status).toBe(200);
    // The utf8 branch carries the bytes as text verbatim — no base64 round-trip.
    expect(await res.text()).toBe(Buffer.from(ORIGINAL_BYTES).toString('utf8'));
  });
});
