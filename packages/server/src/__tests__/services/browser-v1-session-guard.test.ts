import { describe, expect, mock, test } from 'bun:test';

import { fromBinary } from '@bufbuild/protobuf';
import { BROWSER_V1_CARRIER_EVENTS } from '@funny/shared/browser-protocol';
import { StatusCode } from '@funny/shared/browser-v1/common';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';

import { setupBrowserV1SessionGuard } from '../../services/socketio/browser-v1-session-guard.js';
import { createMockSocket } from '../helpers/socketio-test-mocks.js';

describe('browser.v1 session revocation guard', () => {
  test('keeps the authenticated principal active while the session matches', async () => {
    const disconnect = mock(() => {});
    const socket = createMockSocket({
      data: { browserV1: { principalUserId: 'user-1' } },
      handshake: { headers: { cookie: 'session=valid' } },
      disconnect,
    } as any);
    const guard = setupBrowserV1SessionGuard(socket, 'user-1', {
      getSession: async () => ({ user: { id: 'user-1' } }),
      intervalMs: 60_000,
    });

    await expect(guard.checkNow()).resolves.toBe(true);
    expect(disconnect).not.toHaveBeenCalled();
    guard.stop();
  });

  test('disconnects revoked or identity-substituted sessions with a typed outcome', async () => {
    for (const session of [null, { user: { id: 'user-2' } }]) {
      const disconnect = mock(() => {});
      const socket = createMockSocket({
        data: { browserV1: { principalUserId: 'user-1' } },
        handshake: { headers: { cookie: 'session=revoked' } },
        disconnect,
      } as any);
      const guard = setupBrowserV1SessionGuard(socket, 'user-1', {
        getSession: async () => session,
        intervalMs: 60_000,
      });

      await expect(guard.checkNow()).resolves.toBe(false);
      expect(disconnect).toHaveBeenCalledWith(true);
      const control = socket.emitted.find(
        ({ event }) => event === BROWSER_V1_CARRIER_EVENTS.control,
      );
      const decoded = fromBinary(CarrierEnvelopeSchema, control?.data as Uint8Array);
      expect(decoded.payload).toMatchObject({
        case: 'control',
        value: { payload: { case: 'status', value: { code: StatusCode.REVOKED } } },
      });
      guard.stop();
    }
  });

  test('does not disclose typed protocol state before browser.v1 activation', async () => {
    const disconnect = mock(() => {});
    const socket = createMockSocket({
      data: {},
      handshake: { headers: {} },
      disconnect,
    } as any);
    const guard = setupBrowserV1SessionGuard(socket, 'user-1', {
      getSession: async () => null,
      intervalMs: 60_000,
    });

    await expect(guard.checkNow()).resolves.toBe(false);
    expect(socket.emitted).toHaveLength(0);
    expect(disconnect).toHaveBeenCalledWith(true);
    guard.stop();
  });
});
