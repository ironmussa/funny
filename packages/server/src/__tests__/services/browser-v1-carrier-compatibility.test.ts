import { afterEach, describe, expect, test } from 'bun:test';

import { create } from '@bufbuild/protobuf';
import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_SCHEMA_FINGERPRINT,
  decodeBrowserCarrier,
  encodeBrowserCarrier,
} from '@funny/shared/browser-protocol';
import { BrowserCapability } from '@funny/shared/browser-v1/common';
import { NegotiationRequestSchema } from '@funny/shared/browser-v1/negotiation';
import { OperationRequestSchema } from '@funny/shared/browser-v1/operations';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';

import { createSocketIOServer } from '../../services/socketio.js';
import { setupBrowserNamespace } from '../../services/socketio/browser-namespace.js';
import { BrowserV1RolloutPolicy } from '../../services/socketio/browser-v1-rollout.js';
import { FakeRunnerTerminalPort } from '../helpers/runner-port-fakes.js';

const origin = 'http://127.0.0.1:5173';
const cookie = 'funny.session=test-session';

function negotiationPayload(deployment: string): Uint8Array {
  return encodeBrowserCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'negotiationRequest',
        value: create(NegotiationRequestSchema, {
          supportedVersions: [{ major: 1, minor: 0 }],
          generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
          capabilities: [BrowserCapability.OPERATIONS, BrowserCapability.BINARY_POLLING],
          client: { instanceId: `client-${deployment}`, applicationVersion: 'test', deployment },
        }),
      },
    }),
  );
}

function ptyListPayload(requestId: string): Uint8Array {
  return encodeBrowserCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'operation',
        value: {
          payload: {
            case: 'request',
            value: create(OperationRequestSchema, {
              metadata: { requestId },
              operation: { case: 'ptyList', value: {} },
            }),
          },
        },
      },
    }),
  );
}

function waitForConnection(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

describe('browser.v1 carrier transport compatibility', () => {
  const cleanup: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  async function startHarness(options: { runnerAvailable?: boolean } = {}): Promise<string> {
    const { engine } = createSocketIOServer(
      { api: { getSession: async () => ({ user: { id: 'user-1' } }) } },
      [origin],
    );
    const terminals = new FakeRunnerTerminalPort();
    if (options.runnerAvailable !== false) {
      terminals.available.add('runner-1');
      terminals.sessions.set('runner-1\0user-1', [{ ptyId: 'pty-1', cwd: '/workspace' }]);
    }
    setupBrowserNamespace({
      terminals,
      findAnyRunnerForUser: async () => 'runner-1',
      findRunnerForProject: async () => null,
      getRunnerUserId: async () => 'user-1',
      getProjectOwnerId: async () => null,
      browserV1Rollout: new BrowserV1RolloutPolicy({
        operations: 'binary',
        events: 'legacy',
        terminal: 'legacy',
        browserSession: 'legacy',
      }),
    });
    const server = Bun.serve({
      ...engine.handler(),
      port: 0,
      fetch: (request, bunServer) => engine.handleRequest(request, bunServer),
    });
    cleanup.push(async () => {
      server.stop(true);
      await engine.close();
    });
    return server.url.origin;
  }

  async function connect(url: string, transport: 'websocket' | 'polling'): Promise<ClientSocket> {
    const socket = createClient(url, {
      transports: [transport],
      forceNew: true,
      reconnection: false,
      extraHeaders: { Cookie: cookie, Origin: origin },
    });
    cleanup.push(() => {
      socket.disconnect();
    });
    await waitForConnection(socket);
    return socket;
  }

  for (const transport of ['websocket', 'polling'] as const) {
    test(`round-trips binary attachments over ${transport}`, async () => {
      const url = await startHarness();
      const socket = await connect(url, transport);
      const acknowledgement = await socket
        .timeout(2_000)
        .emitWithAck(BROWSER_V1_CARRIER_EVENTS.negotiate, negotiationPayload('web'));
      const decoded = decodeBrowserCarrier(acknowledgement, {
        allowedPayloads: ['negotiationOutcome'],
      });

      expect(socket.io.engine.transport.name).toBe(transport);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.envelope.payload.case).toBe('negotiationOutcome');
      }
    });
  }

  test('renegotiates binary traffic after a reconnect from a WebView deployment', async () => {
    const url = await startHarness();
    const first = await connect(url, 'websocket');
    const firstOutcome = await first
      .timeout(2_000)
      .emitWithAck(BROWSER_V1_CARRIER_EVENTS.negotiate, negotiationPayload('tauri'));
    first.disconnect();

    const reconnected = await connect(url, 'websocket');
    const secondOutcome = await reconnected
      .timeout(2_000)
      .emitWithAck(
        BROWSER_V1_CARRIER_EVENTS.negotiate,
        new Uint8Array(negotiationPayload('tauri').buffer),
      );

    for (const outcome of [firstOutcome, secondOutcome]) {
      expect(decodeBrowserCarrier(outcome, { allowedPayloads: ['negotiationOutcome'] }).ok).toBe(
        true,
      );
    }
  });

  test('runs the pty:list canary over polling after reconnect', async () => {
    const url = await startHarness();
    const first = await connect(url, 'polling');
    await first
      .timeout(2_000)
      .emitWithAck(BROWSER_V1_CARRIER_EVENTS.negotiate, negotiationPayload('web'));
    first.disconnect();

    const reconnected = await connect(url, 'polling');
    await reconnected
      .timeout(2_000)
      .emitWithAck(BROWSER_V1_CARRIER_EVENTS.negotiate, negotiationPayload('web'));
    const wire = await reconnected
      .timeout(2_000)
      .emitWithAck(BROWSER_V1_CARRIER_EVENTS.operation, ptyListPayload('pty-list-reconnect'));
    const decoded = decodeBrowserCarrier(wire, { allowedPayloads: ['operation'] });

    expect(decoded).toMatchObject({
      ok: true,
      envelope: {
        payload: {
          case: 'operation',
          value: {
            payload: {
              case: 'outcome',
              value: {
                requestId: 'pty-list-reconnect',
                outcome: {
                  case: 'success',
                  value: {
                    result: { case: 'ptyList', value: { terminals: [{ ptyId: 'pty-1' }] } },
                  },
                },
              },
            },
          },
        },
      },
    });
  });
});
