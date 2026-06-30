import { describe, test, expect, beforeEach } from 'bun:test';

import { addRunnerClient, removeRunnerClient } from '../../services/ws-relay.js';
import {
  isTunnelTimeoutError,
  TunnelTimeoutError,
  setIO,
  tunnelFetch,
} from '../../services/ws-tunnel.js';
import { MockTunnelTimeoutError } from '../helpers/proxy-test-mocks.js';

describe('isTunnelTimeoutError', () => {
  test('matches native TunnelTimeoutError instances', () => {
    expect(isTunnelTimeoutError(new TunnelTimeoutError('runner-1', 1000))).toBe(true);
  });

  test('matches duck-typed errors from test mocks', () => {
    expect(isTunnelTimeoutError(new MockTunnelTimeoutError('runner-1', 1000))).toBe(true);
  });

  test('rejects generic errors', () => {
    expect(isTunnelTimeoutError(new Error('socket not found'))).toBe(false);
  });
});

describe('tunnelFetch', () => {
  beforeEach(() => {
    removeRunnerClient('r1');
    setIO(null as any);
  });

  function installSocket(options: {
    ackError?: Error | null;
    response?: { status: number; headers: Record<string, string>; body: string | null };
    missingSocket?: boolean;
  }) {
    const emit = (
      _event: string,
      _payload: unknown,
      cb: (err: Error | null, res?: unknown) => void,
    ) => {
      cb(options.ackError ?? null, options.response);
    };
    const socket = options.missingSocket
      ? undefined
      : {
          timeout: (_ms: number) => ({ emit }),
        };

    setIO({
      of: (name: string) =>
        name === '/runner'
          ? { sockets: { get: () => socket } }
          : { sockets: { size: 0 }, adapter: { rooms: new Map() } },
    } as any);

    addRunnerClient('r1', 'sock-r1', 'user-1');
  }

  test('rejects when Socket.IO is not initialized', async () => {
    await expect(
      tunnelFetch('r1', { method: 'GET', path: '/api/health', headers: {} }),
    ).rejects.toThrow(/Socket.IO not initialized/);
  });

  test('rejects when runner is not connected', async () => {
    setIO({ of: () => ({ sockets: { get: () => undefined } }) } as any);
    await expect(
      tunnelFetch('r1', { method: 'GET', path: '/api/health', headers: {} }),
    ).rejects.toThrow(/not connected/);
  });

  test('rejects when socket id is missing from namespace', async () => {
    installSocket({ missingSocket: true });
    await expect(
      tunnelFetch('r1', { method: 'GET', path: '/api/health', headers: {} }),
    ).rejects.toThrow(/socket not found/i);
  });

  test('resolves with runner ack response', async () => {
    installSocket({
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      },
    });

    const res = await tunnelFetch('r1', {
      method: 'POST',
      path: '/api/scheduler/dispatch',
      headers: { 'content-type': 'application/json' },
      body: '{"threadId":"t1"}',
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
  });

  test('rejects with TunnelTimeoutError when ack times out', async () => {
    installSocket({ ackError: new Error('timeout') });

    await expect(
      tunnelFetch('r1', { method: 'GET', path: '/api/health', headers: {} }),
    ).rejects.toMatchObject({ name: 'TunnelTimeoutError', runnerId: 'r1' });
  });
});
