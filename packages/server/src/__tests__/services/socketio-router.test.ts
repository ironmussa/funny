import { describe, test, expect } from 'bun:test';

import {
  registerSocketHandlers,
  registerSocketRpc,
  type SocketEventMiddleware,
} from '../../services/socketio/router.js';
import { createMockSocket } from '../helpers/socketio-test-mocks.js';

describe('socketio router', () => {
  test('registerSocketHandlers skips invalid payloads', async () => {
    const socket = createMockSocket();
    let calls = 0;
    registerSocketHandlers(socket, {
      events: ['demo:event'],
      handler: async () => {
        calls++;
      },
    });

    await socket.trigger('demo:event', []);
    expect(calls).toBe(0);

    await socket.trigger('demo:event', { ok: true });
    expect(calls).toBe(1);
  });

  test('registerSocketHandlers runs middleware chain', async () => {
    const socket = createMockSocket();
    let calls = 0;
    const block: SocketEventMiddleware = () => false;
    registerSocketHandlers(socket, {
      events: ['demo:blocked'],
      middleware: [block],
      handler: async () => {
        calls++;
      },
    });

    await socket.trigger('demo:blocked', { ok: true });
    expect(calls).toBe(0);
  });

  test('registerSocketRpc requires an ack callback', async () => {
    const socket = createMockSocket();
    let ackCalls = 0;
    registerSocketRpc(socket, 'demo:rpc', {
      handler: async (_ctx, ack) => {
        ack({ ok: true });
      },
    });

    await socket.trigger('demo:rpc', {});
    expect(ackCalls).toBe(0);

    await socket.triggerRpc('demo:rpc', {}, () => {
      ackCalls++;
    });
    expect(ackCalls).toBe(1);
  });

  test('registerSocketRpc skips invalid payloads', async () => {
    const socket = createMockSocket();
    let calls = 0;
    registerSocketRpc(socket, 'demo:rpc', {
      handler: async (_ctx, ack, data) => {
        calls++;
        ack({ payload: data });
      },
    });

    await socket.triggerRpc('demo:rpc', [], () => {
      calls++;
    });
    expect(calls).toBe(0);

    await socket.triggerRpc('demo:rpc', { ok: true }, () => {
      calls++;
    });
    expect(calls).toBe(2);
  });
});
